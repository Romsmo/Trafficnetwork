//! What the client tells the host app about: a queue it can drain
//! (`pollEvents`, works in every binding) and, where the language has
//! closures, a listener called as things happen.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use serde::Serialize;

use crate::sync::{BootstrapProgress, EventLogEntry, SyncObserver};

/// The queue keeps the newest this many events; a host app that never polls
/// must not make the client grow without bound.
const MAX_QUEUED: usize = 500;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientEvent {
    /// The static-data download moved on (after every package).
    BootstrapProgress {
        #[serde(rename = "partitionsTotal")]
        partitions_total: usize,
        #[serde(rename = "partitionsDone")]
        partitions_done: usize,
        #[serde(rename = "bytesTotal")]
        bytes_total: u64,
        #[serde(rename = "bytesDone")]
        bytes_done: u64,
    },
    /// A report or a static entity changed through a pulled or pushed event.
    DataChanged {
        #[serde(rename = "entityType")]
        entity_type: String,
        #[serde(rename = "entityId")]
        entity_id: String,
        #[serde(rename = "eventType")]
        event_type: String,
    },
    SyncCompleted {
        #[serde(rename = "pendingWrites")]
        pending_writes: usize,
    },
    SyncFailed {
        code: String,
        message: String,
    },
    /// The local store is full: the host app should ask the user to free
    /// space. Also delivered as the error of the call that hit it.
    StorageFull,
}

type Listener = Arc<dyn Fn(&ClientEvent) + Send + Sync>;

#[derive(Default)]
pub struct EventHub {
    queue: Mutex<VecDeque<ClientEvent>>,
    listener: Mutex<Option<Listener>>,
}

impl EventHub {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn emit(&self, event: ClientEvent) {
        {
            let mut queue = self.queue.lock().unwrap();
            // Progress is a moving value: only the latest is worth keeping.
            let both_progress = matches!(event, ClientEvent::BootstrapProgress { .. })
                && matches!(queue.back(), Some(ClientEvent::BootstrapProgress { .. }));
            if both_progress {
                queue.pop_back();
            }
            if queue.len() >= MAX_QUEUED {
                queue.pop_front();
            }
            queue.push_back(event.clone());
        }
        // Called outside the lock: a listener may well call back into us.
        let listener = self.listener.lock().unwrap().clone();
        if let Some(listener) = listener {
            listener(&event);
        }
    }

    /// Everything queued since the last call, oldest first.
    pub fn drain(&self) -> Vec<ClientEvent> {
        self.queue.lock().unwrap().drain(..).collect()
    }

    pub fn set_listener(&self, listener: Option<Listener>) {
        *self.listener.lock().unwrap() = listener;
    }
}

/// Bridges the sync engine's observer callbacks into the hub.
pub(crate) struct HubObserver(pub(crate) Arc<EventHub>);

impl SyncObserver for HubObserver {
    fn on_bootstrap_progress(&self, progress: &BootstrapProgress) {
        self.0.emit(ClientEvent::BootstrapProgress {
            partitions_total: progress.partitions_total,
            partitions_done: progress.partitions_done,
            bytes_total: progress.bytes_total,
            bytes_done: progress.bytes_done,
        });
    }

    fn on_data_changed(&self, event: &EventLogEntry) {
        self.0.emit(ClientEvent::DataChanged {
            entity_type: event.entity_type.clone(),
            entity_id: event.entity_id.clone(),
            event_type: event.event_type.clone(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn progress(done: usize) -> ClientEvent {
        ClientEvent::BootstrapProgress {
            partitions_total: 10,
            partitions_done: done,
            bytes_total: 100,
            bytes_done: done as u64,
        }
    }

    #[test]
    fn events_come_out_in_order_and_only_once() {
        let hub = EventHub::new();
        hub.emit(ClientEvent::StorageFull);
        hub.emit(ClientEvent::SyncCompleted { pending_writes: 2 });

        assert_eq!(
            hub.drain(),
            vec![
                ClientEvent::StorageFull,
                ClientEvent::SyncCompleted { pending_writes: 2 }
            ]
        );
        assert!(hub.drain().is_empty());
    }

    #[test]
    fn consecutive_progress_events_collapse_into_the_latest() {
        let hub = EventHub::new();
        hub.emit(progress(1));
        hub.emit(progress(2));
        hub.emit(progress(3));
        hub.emit(ClientEvent::StorageFull);
        hub.emit(progress(4));

        assert_eq!(
            hub.drain(),
            vec![progress(3), ClientEvent::StorageFull, progress(4)]
        );
    }

    #[test]
    fn a_host_that_never_polls_cannot_make_the_queue_grow_without_bound() {
        let hub = EventHub::new();
        for _ in 0..(MAX_QUEUED + 50) {
            hub.emit(ClientEvent::StorageFull);
        }
        assert_eq!(hub.drain().len(), MAX_QUEUED);
    }

    #[test]
    fn a_listener_is_called_for_every_event() {
        let hub = EventHub::new();
        let seen = Arc::new(Mutex::new(0));
        let counter = seen.clone();
        hub.set_listener(Some(Arc::new(move |_| *counter.lock().unwrap() += 1)));

        hub.emit(ClientEvent::StorageFull);
        hub.emit(ClientEvent::StorageFull);

        assert_eq!(*seen.lock().unwrap(), 2);
    }

    #[test]
    fn events_serialize_with_a_type_tag_in_camel_case() {
        let json = serde_json::to_value(ClientEvent::SyncCompleted { pending_writes: 3 }).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "type": "syncCompleted", "pendingWrites": 3 })
        );
        let json = serde_json::to_value(progress(1)).unwrap();
        assert_eq!(json["type"], "bootstrapProgress");
        assert_eq!(json["partitionsDone"], 1);
    }
}
