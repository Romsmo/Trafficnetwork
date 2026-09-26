/**
 * Source-neutral roadworks model. Every feed adapter (DATEX II, the Autobahn GmbH JSON, later others) turns its
 * document into `RoadworkCandidate`s; everything after that — deciding what is active *now*, merging the same
 * roadwork seen in two feeds, talking to the server — is written once against this shape.
 */

export interface TimeWindow {
  start: Date;
  end: Date;
}

/**
 * When a roadwork is in force. `windows` (explicit periods, e.g. a night work on 01.10. 22:00–05:00) take
 * precedence over the overall `start`/`end`; without any of them the source did not say and the server's ttl applies.
 */
export interface Validity {
  start?: Date;
  end?: Date;
  windows?: TimeWindow[];
  /** The source describes the times in a form this reader does not evaluate (e.g. recurring daily periods). Such a record is skipped, never guessed. */
  unevaluated?: string;
}

export interface RoadworkCandidate {
  /** The feed's own stable id for this roadwork (with the feed id it is the row's identity on the server). */
  externalId: string;
  /** One representative point (start of the affected stretch). The server stores a point; the full stretch is not kept (yet). */
  lat: number;
  lng: number;
  validity: Validity;
  /** Free text from the source, for the run report only — the server has no place for it. */
  description?: string;
  /** The record is imported, but something about its timing could not be evaluated (e.g. a period only named "day only"); counted in the run report, never silently dropped or silently trusted. */
  caveat?: string;
}

export interface SkippedRecord {
  externalId?: string;
  reason: string;
}

export interface ParseResult {
  candidates: RoadworkCandidate[];
  skipped: SkippedRecord[];
  /** Records/entries seen in the document, whatever happened to them. */
  totalSeen: number;
  /**
   * True only if the WHOLE feed was read: the document parsed to its end (or every sub-request succeeded).
   * A run that is not complete must never retire anything — a truncated download would otherwise "end" every roadwork after the cut.
   */
  complete: boolean;
  /** When the source says it produced the document (DATEX II `publicationTime`), to notice a feed that has silently stopped updating. */
  publishedAt?: Date;
  /** Why `complete` is false. */
  incompleteReason?: string;
}

/** What the run would tell the server about one candidate. */
export interface ActiveRoadwork {
  externalId: string;
  lat: number;
  lng: number;
  /** The end of the currently valid window / the source's end; undefined → the server applies the ttl and renews it on each sighting. */
  endsAt?: Date;
  /** Kept for the cross-feed duplicate check. */
  intervalStart?: Date;
  intervalEnd?: Date;
  caveat?: string;
}
