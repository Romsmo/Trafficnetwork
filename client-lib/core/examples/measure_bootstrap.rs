//! Measures what a full static-data bootstrap costs a client — add-on E, part C.
//!
//! Runs the real `SyncEngine` and `SqliteStore` end to end and reports what
//! the prompt asks for: data transferred, time, local storage size, memory
//! while importing, time to the first speed-limit lookup after a restart, and
//! lookup latency once everything is stored.
//!
//! Two modes, same code path:
//!
//! * `--server URL --client-id ID --client-secret SECRET` (or the environment
//!   variables `TN_CLIENT_ID` / `TN_CLIENT_SECRET`): a real server, real data.
//! * `--synthetic-segments N`: an in-process stand-in for a server that serves
//!   N speed-limit segments (plus a quarter as many signs) in partitions of
//!   `--partition-segments` each, shaped like real Bayern data (about 7.5
//!   vertices per segment, about 400 bytes of JSON per segment) — for sizes
//!   no real server has yet, and for CI. Transfer time is not simulated
//!   (there is no network); the tool says so.
//!
//! What it cannot tell: how a *phone* performs. Timings are of the machine it
//! runs on; the per-entity figures are what to scale from.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use flate2::write::GzEncoder;
use flate2::Compression;
use trafficnetwork_core::discovery::{DiscoveryConfig, DiscoveryService};
use trafficnetwork_core::platform::{
    HttpError, HttpRequest, HttpResponse, HttpTransport, ReqwestHttpTransport, SystemClock,
};
use trafficnetwork_core::storage::SqliteStore;
use trafficnetwork_core::sync::{
    exchange_client_secret, speed_limit_at, BootstrapProgress, SyncEngine, SyncObserver,
};

struct Args {
    server: Option<String>,
    client_id: Option<String>,
    client_secret: Option<String>,
    synthetic_segments: Option<u64>,
    partition_segments: u64,
    db: Option<PathBuf>,
    queries: usize,
    label: String,
    keep_db: bool,
    estimate_gzip: bool,
}

fn usage() -> ! {
    eprintln!(
        "usage: measure_bootstrap (--server URL --client-id ID --client-secret SECRET | --synthetic-segments N)\n\
         \x20      [--partition-segments N] [--db PATH] [--keep-db] [--queries N] [--label TEXT] [--no-gzip-estimate]"
    );
    std::process::exit(2);
}

fn parse_args() -> Args {
    let mut args = Args {
        server: None,
        client_id: std::env::var("TN_CLIENT_ID").ok(),
        client_secret: std::env::var("TN_CLIENT_SECRET").ok(),
        synthetic_segments: None,
        partition_segments: 200_000,
        db: None,
        queries: 2000,
        label: String::new(),
        keep_db: false,
        estimate_gzip: true,
    };
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let mut value = || it.next().unwrap_or_else(|| usage());
        match flag.as_str() {
            "--server" => args.server = Some(value()),
            "--client-id" => args.client_id = Some(value()),
            "--client-secret" => args.client_secret = Some(value()),
            "--synthetic-segments" => {
                args.synthetic_segments = Some(value().parse().unwrap_or_else(|_| usage()))
            }
            "--partition-segments" => {
                args.partition_segments = value().parse().unwrap_or_else(|_| usage())
            }
            "--db" => args.db = Some(PathBuf::from(value())),
            "--queries" => args.queries = value().parse().unwrap_or_else(|_| usage()),
            "--label" => args.label = value(),
            "--keep-db" => args.keep_db = true,
            "--no-gzip-estimate" => args.estimate_gzip = false,
            _ => usage(),
        }
    }
    if args.synthetic_segments.is_none()
        && (args.server.is_none() || args.client_id.is_none() || args.client_secret.is_none())
    {
        usage();
    }
    args
}

// ------------------------------------------------------------------ transport

/// Wraps a transport and counts what crosses it: bytes (as the app sees them,
/// which is what goes over the wire today — the server does not compress),
/// how long the calls themselves took, and what the partitions would compress
/// to with gzip.
struct CountingTransport {
    inner: Arc<dyn HttpTransport>,
    estimate_gzip: bool,
    requests: AtomicU64,
    bytes: AtomicU64,
    partition_bytes: AtomicU64,
    gzip_partition_bytes: AtomicU64,
    largest_partition_bytes: AtomicU64,
    transport_nanos: AtomicU64,
    gzip_nanos: AtomicU64,
}

impl CountingTransport {
    fn new(inner: Arc<dyn HttpTransport>, estimate_gzip: bool) -> Self {
        Self {
            inner,
            estimate_gzip,
            requests: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
            partition_bytes: AtomicU64::new(0),
            gzip_partition_bytes: AtomicU64::new(0),
            largest_partition_bytes: AtomicU64::new(0),
            transport_nanos: AtomicU64::new(0),
            gzip_nanos: AtomicU64::new(0),
        }
    }
}

fn gzip_len(body: &[u8]) -> u64 {
    let mut encoder = GzEncoder::new(CountingSink(0), Compression::new(6));
    encoder.write_all(body).expect("gzip into a counter cannot fail");
    encoder.finish().expect("gzip into a counter cannot fail").0
}

struct CountingSink(u64);
impl std::io::Write for CountingSink {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0 += buf.len() as u64;
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[async_trait::async_trait]
impl HttpTransport for CountingTransport {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, HttpError> {
        let is_partition = request.url.contains("/v1/static-data/partitions/");
        let started = Instant::now();
        let response = self.inner.send(request).await;
        let took = started.elapsed().as_nanos() as u64;
        self.transport_nanos.fetch_add(took, Ordering::Relaxed);
        if let Ok(r) = &response {
            let len = r.body.len() as u64;
            self.requests.fetch_add(1, Ordering::Relaxed);
            self.bytes.fetch_add(len, Ordering::Relaxed);
            if is_partition {
                self.partition_bytes.fetch_add(len, Ordering::Relaxed);
                self.largest_partition_bytes.fetch_max(len, Ordering::Relaxed);
                if self.estimate_gzip {
                    let gz_started = Instant::now();
                    let gz = gzip_len(&r.body);
                    self.gzip_nanos
                        .fetch_add(gz_started.elapsed().as_nanos() as u64, Ordering::Relaxed);
                    self.gzip_partition_bytes.fetch_add(gz, Ordering::Relaxed);
                }
            }
        }
        response
    }
}

// ------------------------------------------------------------ synthetic server

struct Rng(u64);
impl Rng {
    fn new(seed: u64) -> Self {
        let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
        for _ in 0..4 {
            rng.next_u64();
        }
        rng
    }
    fn next_u64(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next_u64() % n
    }
    fn uuid(&mut self) -> String {
        let (a, b) = (self.next_u64(), self.next_u64());
        format!(
            "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
            a >> 32,
            (a >> 16) & 0xffff,
            a & 0xffff,
            b >> 48,
            b & 0xffff_ffff_ffff
        )
    }
}

const LIMITS: [u32; 8] = [30, 50, 60, 70, 80, 100, 120, 130];

struct SyntheticTransport {
    segments: u64,
    per_partition: u64,
}

impl SyntheticTransport {
    fn partitions(&self) -> u64 {
        self.segments.div_ceil(self.per_partition)
    }

    fn segments_in(&self, index: u64) -> u64 {
        let before = index * self.per_partition;
        self.per_partition.min(self.segments.saturating_sub(before))
    }

    fn manifest(&self) -> Vec<u8> {
        let partitions: Vec<String> = (0..self.partitions())
            .map(|i| {
                let segments = self.segments_in(i);
                // An estimate (about 420 B per segment, 214 B per sign, as
                // measured on real data) — the manifest is not the payload.
                let size = segments * 420 + segments / 4 * 214;
                format!(r#"{{"tile":"synth-{i}","hash":"h{i}","sizeBytes":{size}}}"#)
            })
            .collect();
        format!(
            r#"{{"staticDataVersion":1,"generatedAt":"2026-09-24T00:00:00Z","partitions":[{}]}}"#,
            partitions.join(",")
        )
        .into_bytes()
    }

    /// Writes the JSON text directly, without building structures first, so
    /// the memory this costs is the body itself — like a real response.
    fn partition(&self, index: u64) -> Vec<u8> {
        let segments = self.segments_in(index);
        let signs = segments / 4;
        let mut rng = Rng::new(index + 1);
        let cell_lng = -10.0 + (index % 20) as f64 * 3.0;
        let cell_lat = 36.0 + ((index / 20) % 10) as f64 * 3.0;
        let mut out = Vec::with_capacity((segments * 430 + signs * 220) as usize);
        write!(out, r#"{{"tile":"synth-{index}","speedLimitSegments":["#).unwrap();
        for n in 0..segments {
            if n > 0 {
                out.push(b',');
            }
            let vertices = 2 + rng.below(12);
            let mut lng = cell_lng + rng.unit() * 3.0;
            let mut lat = cell_lat + rng.unit() * 3.0;
            let id = rng.uuid();
            write!(
                out,
                r#"{{"id":"{id}","geometry":{{"type":"LineString","coordinates":["#
            )
            .unwrap();
            for v in 0..vertices {
                if v > 0 {
                    out.push(b',');
                }
                write!(out, "[{lng:.7},{lat:.7}]").unwrap();
                lng += (rng.unit() - 0.5) * 0.0006;
                lat += (rng.unit() - 0.5) * 0.0006;
            }
            let limit = LIMITS[rng.below(LIMITS.len() as u64) as usize];
            let key = format!("{:016x}{:016x}", rng.next_u64(), rng.next_u64());
            write!(
                out,
                r#"]}},"speedLimit":{limit},"speedLimitUnit":"kmh","source":"osm","sourceLicense":"ODbL","importedAt":"2026-09-23T15:02:11.123Z","lastConfirmedAt":null,"segmentKey":"{key}"}}"#
            )
            .unwrap();
        }
        out.extend_from_slice(br#"],"staticSigns":["#);
        for n in 0..signs {
            if n > 0 {
                out.push(b',');
            }
            let id = rng.uuid();
            let lng = cell_lng + rng.unit() * 3.0;
            let lat = cell_lat + rng.unit() * 3.0;
            write!(
                out,
                r#"{{"id":"{id}","position":{{"type":"Point","coordinates":[{lng:.7},{lat:.7}]}},"signType":"DE:274","source":"osm","sourceLicense":"ODbL","importedAt":"2026-09-23T15:02:11.123Z"}}"#
            )
            .unwrap();
        }
        out.extend_from_slice(br#"],"fixedSpeedCameras":[]}"#);
        out
    }
}

#[async_trait::async_trait]
impl HttpTransport for SyntheticTransport {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, HttpError> {
        let path = request.url.split("synthetic.invalid").nth(1).unwrap_or("");
        let body = if path == "/v1/static-data/manifest" {
            self.manifest()
        } else if let Some(tile) = path.strip_prefix("/v1/static-data/partitions/synth-") {
            match tile.parse::<u64>() {
                Ok(index) if index < self.partitions() => self.partition(index),
                _ => return Ok(HttpResponse { status: 404, body: Vec::new() }),
            }
        } else {
            return Ok(HttpResponse { status: 404, body: Vec::new() });
        };
        Ok(HttpResponse { status: 200, body })
    }
}

// ------------------------------------------------------------------ measuring

fn start_memory_sampler() -> (Arc<AtomicUsize>, Arc<AtomicBool>, std::thread::JoinHandle<()>) {
    let peak = Arc::new(AtomicUsize::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let handle = {
        let (peak, stop) = (peak.clone(), stop.clone());
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                if let Some(usage) = memory_stats::memory_stats() {
                    peak.fetch_max(usage.physical_mem, Ordering::Relaxed);
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        })
    };
    (peak, stop, handle)
}

struct ProgressPrinter {
    started: Instant,
}

impl SyncObserver for ProgressPrinter {
    fn on_bootstrap_progress(&self, p: &BootstrapProgress) {
        eprintln!(
            "  partition {}/{}   {:.0} of {:.0} MB   {:.0} s",
            p.partitions_done,
            p.partitions_total,
            p.bytes_done as f64 / 1e6,
            p.bytes_total as f64 / 1e6,
            self.started.elapsed().as_secs_f64()
        );
    }
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let index = ((sorted.len() - 1) as f64 * p).round() as usize;
    sorted[index]
}

fn remove_db_files(path: &Path) {
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

fn file_size(path: &str) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

fn mb(bytes: f64) -> f64 {
    bytes / 1e6
}

#[tokio::main]
async fn main() {
    let args = parse_args();
    let db_path = args
        .db
        .clone()
        .unwrap_or_else(|| std::env::temp_dir().join(format!("tn-measure-{}.db", std::process::id())));
    if !args.keep_db {
        remove_db_files(&db_path);
    }
    let synthetic = args.synthetic_segments.is_some();

    let inner: Arc<dyn HttpTransport> = match args.synthetic_segments {
        Some(segments) => Arc::new(SyntheticTransport {
            segments,
            per_partition: args.partition_segments.max(1),
        }),
        None => Arc::new(ReqwestHttpTransport::new().expect("could not build the HTTP client")),
    };
    let counting = Arc::new(CountingTransport::new(inner, args.estimate_gzip));
    let base = args
        .server
        .clone()
        .unwrap_or_else(|| "http://synthetic.invalid".to_string());
    let discovery = Arc::new(DiscoveryService::new(
        counting.clone(),
        Arc::new(SystemClock),
        DiscoveryConfig::default(),
    ));
    discovery.seed_fixed_nodes(&[("measure".to_string(), base)]);
    let token = match (&args.client_id, &args.client_secret) {
        (Some(id), Some(secret)) if !synthetic => exchange_client_secret(&discovery, id, secret)
            .await
            .expect("could not get a token from the server")
            .access_token,
        _ => "synthetic".to_string(),
    };

    let store = Arc::new(SqliteStore::open(&db_path).expect("could not open the database"));
    let engine = SyncEngine::new(discovery, store.clone(), Arc::new(SystemClock)).with_observer(
        Arc::new(ProgressPrinter {
            started: Instant::now(),
        }),
    );

    let (peak, stop, sampler) = start_memory_sampler();
    std::thread::sleep(Duration::from_millis(50));
    let baseline_memory = peak.load(Ordering::Relaxed);

    eprintln!("planning ...");
    let plan_started = Instant::now();
    let plan = engine
        .plan_static_bootstrap(&token)
        .await
        .expect("could not fetch the manifest");
    let manifest_secs = plan_started.elapsed().as_secs_f64();
    eprintln!(
        "manifest: {} partitions, {:.1} MB to download ({manifest_secs:.2} s)",
        plan.partitions_pending,
        mb(plan.bytes_pending as f64)
    );

    let transport_before = counting.transport_nanos.load(Ordering::Relaxed);
    let gzip_before = counting.gzip_nanos.load(Ordering::Relaxed);
    let started = Instant::now();
    engine
        .sync_static_data(&token)
        .await
        .expect("the bootstrap failed");
    let total_secs = started.elapsed().as_secs_f64();
    let transport_secs =
        (counting.transport_nanos.load(Ordering::Relaxed) - transport_before) as f64 / 1e9;
    let gzip_secs = (counting.gzip_nanos.load(Ordering::Relaxed) - gzip_before) as f64 / 1e9;
    let processing_secs = (total_secs - transport_secs - gzip_secs).max(0.0);

    stop.store(true, Ordering::Relaxed);
    let _ = sampler.join();
    let peak_memory = peak.load(Ordering::Relaxed);

    store.checkpoint().expect("checkpoint failed");
    let (segments, signs, cameras) = store.entity_counts().expect("could not count");
    let entities = (segments + signs + cameras).max(1);
    let db_bytes = file_size(&db_path.display().to_string());
    let wal_bytes = file_size(&format!("{}-wal", db_path.display()));

    // A restart: drop everything, reopen the file, ask.
    drop(engine);
    drop(store);
    let reopen_started = Instant::now();
    let store = SqliteStore::open(&db_path).expect("could not reopen the database");
    let reopen_secs = reopen_started.elapsed().as_secs_f64();
    let positions = store
        .sample_positions(args.queries.max(1))
        .expect("could not sample positions");
    let first = positions.first().copied().unwrap_or((48.137, 11.575));
    let first_started = Instant::now();
    let first_result = speed_limit_at(&store, first.0, first.1, 50.0).expect("lookup failed");
    let first_query_secs = first_started.elapsed().as_secs_f64();
    let mut latencies_ms = Vec::with_capacity(positions.len());
    let mut found = 0usize;
    for (lat, lng) in &positions {
        let started = Instant::now();
        let hit = speed_limit_at(&store, *lat, *lng, 50.0).expect("lookup failed");
        latencies_ms.push(started.elapsed().as_secs_f64() * 1000.0);
        found += usize::from(hit.is_some());
    }
    latencies_ms.sort_by(f64::total_cmp);

    let wire_bytes = counting.bytes.load(Ordering::Relaxed);
    let partition_bytes = counting.partition_bytes.load(Ordering::Relaxed);
    let gzip_bytes = counting.gzip_partition_bytes.load(Ordering::Relaxed);
    let largest = counting.largest_partition_bytes.load(Ordering::Relaxed);
    let mem_over_baseline = peak_memory.saturating_sub(baseline_memory);

    println!();
    println!("=== bootstrap measurement {} ===", args.label);
    println!(
        "source            : {}",
        if synthetic { "SYNTHETIC (shaped like real Bayern data; no network involved)" } else { "real server" }
    );
    println!("machine           : {} / {}, {} cores, {}", std::env::consts::OS, std::env::consts::ARCH,
        std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
        if cfg!(debug_assertions) { "DEBUG build (numbers are not representative)" } else { "release build" });
    println!("entities          : {segments} segments, {signs} signs, {cameras} cameras ({entities} total)");
    println!("partitions        : {} (largest {:.1} MB)", plan.partitions_pending, mb(largest as f64));
    println!("--- transfer ---");
    println!("bytes on the wire : {:.1} MB in {} requests (server does not compress today)", mb(wire_bytes as f64), counting.requests.load(Ordering::Relaxed));
    if args.estimate_gzip {
        println!("with gzip         : {:.1} MB ({:.1}% of raw)", mb(gzip_bytes as f64), gzip_bytes as f64 * 100.0 / partition_bytes.max(1) as f64);
    }
    println!("--- time (this machine) ---");
    println!("manifest          : {manifest_secs:.2} s");
    println!("bootstrap total   : {total_secs:.1} s   (transport {transport_secs:.1} s{}, processing {processing_secs:.1} s = parse + store)",
        if synthetic { " = generating the synthetic body, not a network" } else { "" });
    println!("processing / entity: {:.1} µs", processing_secs * 1e6 / entities as f64);
    println!("--- storage & memory ---");
    println!("database file     : {:.1} MB (+ {:.1} MB WAL before checkpoint)  = {:.0} B/entity", mb(db_bytes as f64), mb(wal_bytes as f64), db_bytes as f64 / entities as f64);
    println!("process memory    : peak {:.0} MB working set ({:.0} MB above the {:.0} MB baseline)", mb(peak_memory as f64), mb(mem_over_baseline as f64), mb(baseline_memory as f64));
    println!("--- after a restart ---");
    println!("open database     : {:.1} ms", reopen_secs * 1000.0);
    println!("first lookup      : {:.2} ms (found: {})", first_query_secs * 1000.0, first_result.is_some());
    println!("lookups           : {} at random stored positions, {} found; p50 {:.3} ms, p95 {:.3} ms, p99 {:.3} ms, max {:.3} ms",
        latencies_ms.len(), found, percentile(&latencies_ms, 0.5), percentile(&latencies_ms, 0.95), percentile(&latencies_ms, 0.99), latencies_ms.last().copied().unwrap_or(0.0));

    println!("--- transfer time at other speeds (arithmetic from the bytes above, not measured) ---");
    for mbit in [1.0, 5.0, 20.0, 100.0] {
        let secs = |bytes: u64| bytes as f64 * 8.0 / (mbit * 1e6);
        let raw = secs(wire_bytes);
        let gz = secs(gzip_bytes);
        if args.estimate_gzip {
            println!("{mbit:>5} Mbit/s     : {:.1} min raw, {:.1} min gzipped", raw / 60.0, gz / 60.0);
        } else {
            println!("{mbit:>5} Mbit/s     : {:.1} min raw", raw / 60.0);
        }
    }
    println!("--- linear scaling from this run (an extrapolation, not a measurement) ---");
    for target in [5_000_000u64, 10_000_000, 20_000_000, 40_000_000] {
        let factor = target as f64 / entities as f64;
        println!(
            "{:>4}M entities : {:.1} GB on the wire, {:.1} GB gzipped, {:.1} GB database, {:.1} min processing here",
            target / 1_000_000,
            wire_bytes as f64 * factor / 1e9,
            gzip_bytes as f64 * factor / 1e9,
            db_bytes as f64 * factor / 1e9,
            processing_secs * factor / 60.0
        );
    }
    println!("(peak memory does not scale with the total: it follows the largest partition, {:.1} MB here)", mb(largest as f64));

    let result = serde_json::json!({
        "label": args.label,
        "synthetic": synthetic,
        "segments": segments, "signs": signs, "cameras": cameras,
        "partitions": plan.partitions_pending, "largestPartitionBytes": largest,
        "wireBytes": wire_bytes, "gzipPartitionBytes": gzip_bytes,
        "manifestSeconds": manifest_secs, "bootstrapSeconds": total_secs,
        "transportSeconds": transport_secs, "processingSeconds": processing_secs,
        "databaseBytes": db_bytes, "walBytes": wal_bytes,
        "peakMemoryBytes": peak_memory, "baselineMemoryBytes": baseline_memory,
        "openSeconds": reopen_secs, "firstQuerySeconds": first_query_secs,
        "queryP50Ms": percentile(&latencies_ms, 0.5), "queryP95Ms": percentile(&latencies_ms, 0.95),
        "queryP99Ms": percentile(&latencies_ms, 0.99),
        "queries": latencies_ms.len(), "queriesFound": found,
    });
    println!("RESULT_JSON {}", serde_json::to_string(&result).unwrap());

    if !args.keep_db {
        drop(store);
        remove_db_files(&db_path);
    }
}
