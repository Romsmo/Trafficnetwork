/**
 * The default legal notice that goes with camera data (docs/camera-country-policy.md, 5.5). The server carries it in
 * `GET /v1/config` (`cameraPolicy.notice`) so that the web UI and the client library show one wording; a host may ship
 * its own translation, and bumps nothing here when it does.
 *
 * It is a notice to the *user*, not a legal assessment, and not the operator's legal review: the statements are the
 * project owner's wording, and the operator of a node must have them checked for the countries they release before any
 * level above `off` is signed. `version` changes whenever the meaning of the text changes, so a client that asked the
 * user to acknowledge version 1 knows to ask again for version 2.
 */
export const CAMERA_NOTICE = {
  version: 1,
  text: {
    de: "Hinweis: Die Nutzung von Blitzer-Hinweisen während der Fahrt ist in mehreren Ländern verboten — in Deutschland auch für Beifahrer. In der Schweiz sind selbst Hinweise unzulässig. Informiere dich über die Rechtslage des Landes, in dem du unterwegs bist.",
    en: "Notice: Using speed-camera information while driving is prohibited in several countries — in Germany also for passengers. In Switzerland even hints are unlawful. Find out about the law of the country you are travelling in.",
  },
} as const;
