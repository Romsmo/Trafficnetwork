"""Trafficnetwork client library for Python — a thin wrapper around the C ABI
(`libtrafficnetwork`), built with `ctypes` only (no compiler, no dependencies).

    from trafficnetwork import Client

    client = Client({
        "storagePath": "/var/lib/myapp/trafficnetwork",
        "credentials": {"type": "app", "appClientId": "...", "appClientSecret": "..."},
    })
    client.update_position(52.52, 13.405)
    client.tick()                                   # syncs when due
    print(client.get_speed_limit_at(52.52, 13.405)) # answered from the local store

Every method is the API method of the same name (`client-lib/docs/api.md`), in
snake_case; `call(method, args)` runs any method by its JSON name. Failures
raise :class:`TrafficNetworkError` with a machine-readable ``code``.

The native library is found through, in this order: the ``library_path``
argument, the ``TRAFFICNETWORK_LIB`` environment variable, and a file next to
this package.
"""

from __future__ import annotations

import ctypes
import json
import os
import sys
from ctypes import CFUNCTYPE, POINTER, c_char_p, c_int32, c_void_p
from typing import Any, Callable, Dict, List, Optional

__all__ = ["Client", "SecureStore", "TrafficNetworkError", "library_version"]

_EVENT_CALLBACK = CFUNCTYPE(None, c_void_p, c_char_p)
_RESULT_CALLBACK = CFUNCTYPE(None, c_void_p, c_char_p)
_SECURE_GET = CFUNCTYPE(c_int32, c_void_p, c_char_p, c_void_p, c_int32)
_SECURE_SET = CFUNCTYPE(c_int32, c_void_p, c_char_p, c_char_p)
_SECURE_DELETE = CFUNCTYPE(c_int32, c_void_p, c_char_p)


class TrafficNetworkError(Exception):
    """An error reported by the library: ``code`` is one of the API's error codes
    (``invalidArgument``, ``notConfigured``, ``storageFull``, ``network``, ``auth``,
    ``closed``, ...)."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


class SecureStore:
    """Where the device's secrets are kept, if not in the library's own file.
    Implement these three methods on top of the platform's keystore."""

    def get(self, key: str) -> Optional[str]:  # pragma: no cover - interface
        raise NotImplementedError

    def set(self, key: str, value: str) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    def delete(self, key: str) -> None:  # pragma: no cover - interface
        raise NotImplementedError


_library = None


def _library_names() -> List[str]:
    if sys.platform == "win32":
        return ["trafficnetwork.dll"]
    if sys.platform == "darwin":
        return ["libtrafficnetwork.dylib"]
    return ["libtrafficnetwork.so"]


def _load(library_path: Optional[str] = None):
    global _library
    if _library is not None and library_path is None:
        return _library
    candidates: List[str] = []
    if library_path:
        candidates.append(library_path)
    if os.environ.get("TRAFFICNETWORK_LIB"):
        candidates.append(os.environ["TRAFFICNETWORK_LIB"])
    here = os.path.dirname(os.path.abspath(__file__))
    candidates += [os.path.join(here, name) for name in _library_names()]
    last_error: Optional[Exception] = None
    for candidate in candidates:
        try:
            lib = ctypes.CDLL(candidate)
        except OSError as error:
            last_error = error
            continue
        lib.tn_client_new.restype = c_void_p
        lib.tn_client_new.argtypes = [c_char_p, POINTER(c_void_p)]
        lib.tn_client_new_with_secure_store.restype = c_void_p
        lib.tn_client_new_with_secure_store.argtypes = [
            c_char_p, _SECURE_GET, _SECURE_SET, _SECURE_DELETE, c_void_p, POINTER(c_void_p),
        ]
        lib.tn_client_call.restype = c_void_p
        lib.tn_client_call.argtypes = [c_void_p, c_char_p, c_char_p]
        lib.tn_client_call_async.restype = None
        lib.tn_client_call_async.argtypes = [c_void_p, c_char_p, c_char_p, _RESULT_CALLBACK, c_void_p]
        lib.tn_client_set_event_callback.restype = None
        lib.tn_client_set_event_callback.argtypes = [c_void_p, _EVENT_CALLBACK, c_void_p]
        lib.tn_client_start_realtime.restype = c_int32
        lib.tn_client_start_realtime.argtypes = [c_void_p]
        lib.tn_client_stop_realtime.restype = None
        lib.tn_client_stop_realtime.argtypes = [c_void_p]
        lib.tn_client_free.restype = None
        lib.tn_client_free.argtypes = [c_void_p]
        lib.tn_library_version.restype = c_void_p
        lib.tn_library_version.argtypes = []
        lib.tn_free_string.restype = None
        lib.tn_free_string.argtypes = [c_void_p]
        _library = lib
        return lib
    raise OSError(
        "the trafficnetwork native library was not found (set TRAFFICNETWORK_LIB); "
        f"tried {candidates}: {last_error}"
    )


def _take(lib, pointer: Optional[int]) -> str:
    """Copies a library-allocated string and frees it."""
    if not pointer:
        raise TrafficNetworkError("internal", "the library returned no result")
    try:
        return ctypes.string_at(pointer).decode("utf-8")
    finally:
        lib.tn_free_string(pointer)


def _unwrap(envelope: Dict[str, Any]) -> Any:
    if "error" in envelope:
        error = envelope["error"]
        raise TrafficNetworkError(error.get("code", "internal"), error.get("message", ""))
    return envelope.get("ok")


def library_version(library_path: Optional[str] = None) -> str:
    lib = _load(library_path)
    return _take(lib, lib.tn_library_version())


class Client:
    def __init__(
        self,
        options: Dict[str, Any],
        secure_store: Optional[SecureStore] = None,
        library_path: Optional[str] = None,
    ):
        """``options`` are the client options (``storagePath`` is required) — see the API
        documentation. With ``secure_store`` the device's secrets go there instead of a file."""
        self._lib = _load(library_path)
        self._handle: Optional[int] = None
        self._keep_alive: List[Any] = []
        self._listener: Optional[Callable[[Dict[str, Any]], None]] = None
        encoded = json.dumps(options).encode("utf-8")
        error = c_void_p()
        if secure_store is None:
            handle = self._lib.tn_client_new(encoded, ctypes.byref(error))
        else:
            get, set_, delete = self._secure_callbacks(secure_store)
            handle = self._lib.tn_client_new_with_secure_store(
                encoded, get, set_, delete, None, ctypes.byref(error)
            )
        if not handle:
            _unwrap(json.loads(_take(self._lib, error.value)))
            raise TrafficNetworkError("internal", "the client could not be created")
        self._handle = handle

    def _secure_callbacks(self, store: SecureStore):
        def get(_user, key, buffer, capacity):
            try:
                value = store.get(key.decode("utf-8"))
            except Exception:  # a store that fails answers "not there"
                return -1
            if value is None:
                return -1
            data = value.encode("utf-8")
            if len(data) >= capacity:
                return -1
            ctypes.memmove(buffer, data + b"\0", len(data) + 1)
            return len(data)

        def set_(_user, key, value):
            try:
                store.set(key.decode("utf-8"), value.decode("utf-8"))
                return 0
            except Exception:
                return 1

        def delete(_user, key):
            try:
                store.delete(key.decode("utf-8"))
                return 0
            except Exception:
                return 1

        callbacks = (_SECURE_GET(get), _SECURE_SET(set_), _SECURE_DELETE(delete))
        self._keep_alive.extend(callbacks)
        return callbacks

    # ------------------------------------------------------------------ core

    def call(self, method: str, args: Optional[Dict[str, Any]] = None) -> Any:
        """Runs one API method by name and returns its result (blocking).
        Raises :class:`TrafficNetworkError` for an error."""
        if not self._handle:
            raise TrafficNetworkError("closed", "the client was freed")
        encoded = json.dumps(args if args is not None else {}).encode("utf-8")
        text = _take(self._lib, self._lib.tn_client_call(self._handle, method.encode("utf-8"), encoded))
        return _unwrap(json.loads(text))

    def call_async(
        self,
        method: str,
        args: Optional[Dict[str, Any]],
        done: Callable[[Any, Optional[TrafficNetworkError]], None],
    ) -> None:
        """Runs a method without blocking; ``done(result, error)`` is called from a library thread."""
        if not self._handle:
            raise TrafficNetworkError("closed", "the client was freed")
        encoded = json.dumps(args if args is not None else {}).encode("utf-8")

        def deliver(_user, text):
            try:
                result, error = _unwrap(json.loads(text.decode("utf-8"))), None
            except TrafficNetworkError as failure:
                result, error = None, failure
            finally:
                self._keep_alive.remove(callback)
            done(result, error)

        callback = _RESULT_CALLBACK(deliver)
        self._keep_alive.append(callback)
        self._lib.tn_client_call_async(self._handle, method.encode("utf-8"), encoded, callback, None)

    def on_event(self, listener: Optional[Callable[[Dict[str, Any]], None]]) -> None:
        """Calls ``listener(event)`` for every event, from a library thread. ``None`` removes it."""
        if not self._handle:
            raise TrafficNetworkError("closed", "the client was freed")
        if listener is None:
            self._lib.tn_client_set_event_callback(self._handle, _EVENT_CALLBACK(), None)
            self._listener = None
            return

        def deliver(_user, text):
            listener(json.loads(text.decode("utf-8")))

        callback = _EVENT_CALLBACK(deliver)
        self._listener = callback  # keeps it alive
        self._lib.tn_client_set_event_callback(self._handle, callback, None)

    def start_realtime(self) -> None:
        """Keeps a WebSocket open and applies pushed events, on a library thread — no
        thread or event loop of your own needed. A no-op if already running."""
        if not self._handle:
            raise TrafficNetworkError("closed", "the client was freed")
        if self._lib.tn_client_start_realtime(self._handle) != 0:
            raise TrafficNetworkError("internal", "realtime push could not be started")

    def stop_realtime(self) -> None:
        """Asks a running realtime task to stop — between connection attempts, not by
        force-closing an open connection. A no-op if none is running."""
        if self._handle:
            self._lib.tn_client_stop_realtime(self._handle)

    def free(self) -> None:
        """Releases the client. Its data stays on disk. Safe to call twice."""
        if self._handle:
            handle, self._handle = self._handle, None
            self._lib.tn_client_free(handle)

    def __enter__(self) -> "Client":
        return self

    def __exit__(self, *_exc) -> None:
        self.free()

    def __del__(self) -> None:  # pragma: no cover - best effort
        try:
            self.free()
        except Exception:
            pass

    # ------------------------------------------------------- the API methods

    def version(self) -> Dict[str, Any]:
        return self.call("version")

    def get_speed_limit_at(self, lat: float, lng: float, heading: Optional[float] = None):
        """The limit in effect at a position, or ``None``. Local, never blocks on the network."""
        args: Dict[str, Any] = {"lat": lat, "lng": lng}
        if heading is not None:
            args["heading"] = heading
        return self.call("getSpeedLimitAt", args)

    def get_nearby(self, lat: float, lng: float, radius_meters: float, categories: Optional[List[str]] = None):
        """Reports, signs and (only if allowed) cameras around a position, nearest first."""
        args: Dict[str, Any] = {"lat": lat, "lng": lng, "radiusMeters": radius_meters}
        if categories:
            args["categories"] = categories
        return self.call("getNearby", args)["items"]

    def submit_report(self, hazard_type: str, lat: float, lng: float, speed_kmh: Optional[float] = None) -> str:
        args: Dict[str, Any] = {"type": hazard_type, "lat": lat, "lng": lng}
        if speed_kmh is not None:
            args["speedKmh"] = speed_kmh
        return self.call("submitReport", args)["localId"]

    def confirm_report(self, report_id: str, still_there: bool) -> str:
        return self.call("confirmReport", {"reportId": report_id, "stillThere": still_there})["localId"]

    def report_camera_removed(self, camera_id: str) -> str:
        return self.call("reportCameraRemoved", {"cameraId": camera_id})["localId"]

    def report_wrong_speed_limit(self, proposed_value: int, unit: str, segment_id: Optional[str] = None,
                                 lat: Optional[float] = None, lng: Optional[float] = None,
                                 reason: Optional[str] = None):
        args: Dict[str, Any] = {"proposedValue": proposed_value, "unit": unit}
        if segment_id is not None:
            args["segmentId"] = segment_id
        if lat is not None and lng is not None:
            args["lat"], args["lng"] = lat, lng
        if reason is not None:
            args["reason"] = reason
        return self.call("reportWrongSpeedLimit", args)

    def confirm_speed_limit_correction(self, agrees: bool, segment_id: Optional[str] = None,
                                       correction: Optional[Dict[str, Any]] = None):
        args: Dict[str, Any] = {"agrees": agrees}
        if segment_id is not None:
            args["segmentId"] = segment_id
        if correction is not None:
            args["correction"] = correction
        return self.call("confirmSpeedLimitCorrection", args)["localId"]

    def fetch_corrections(self) -> List[Dict[str, Any]]:
        return self.call("fetchCorrections")["corrections"]

    def update_position(self, lat: float, lng: float, speed_kmh: Optional[float] = None):
        args: Dict[str, Any] = {"lat": lat, "lng": lng}
        if speed_kmh is not None:
            args["speedKmh"] = speed_kmh
        return self.call("updatePosition", args)

    def sync(self):
        """One full sync cycle; blocks until it is done."""
        return self.call("sync")

    def tick(self):
        """Syncs if it is due, otherwise does nothing — cheap to call often."""
        return self.call("tick")

    def plan_bootstrap(self):
        """What the static-data download still needs, before it starts."""
        return self.call("planBootstrap")

    def get_sync_status(self):
        return self.call("getSyncStatus")

    def get_network_status(self):
        return self.call("getNetworkStatus")

    def poll_events(self) -> List[Dict[str, Any]]:
        return self.call("pollEvents")["events"]

    def close(self) -> None:
        """Closes the client (every later call fails with ``closed``); ``free()`` releases it."""
        self.call("close")
