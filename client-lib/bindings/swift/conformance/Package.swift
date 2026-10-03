// swift-tools-version:5.9
//
// A conformance bridge for the Swift package (see conformance/README.md,
// "Bridges"): lets conformance/run_bridge.mjs drive the generated Swift
// binding with the scenarios every other binding runs. It is the one place
// outside the library's own tests that uses the package like an app would.
import PackageDescription

let package = Package(
    name: "TrafficNetworkBridge",
    platforms: [.macOS(.v11)],
    dependencies: [
        .package(path: ".."),
    ],
    targets: [
        .executableTarget(
            name: "TrafficNetworkBridge",
            dependencies: [.product(name: "TrafficNetwork", package: "swift")],
            path: "Sources/TrafficNetworkBridge"
        ),
    ]
)
