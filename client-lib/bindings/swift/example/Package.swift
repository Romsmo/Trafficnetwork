// swift-tools-version:5.9
//
// The minimal example of docs/integration-ios.md as a command-line program, so
// it can be run (and is, in CI) against a server. The same calls go inside a
// SwiftUI view or a view controller in an app: see the guide.
import PackageDescription

let package = Package(
    name: "TrafficNetworkExample",
    platforms: [.macOS(.v11)],
    dependencies: [
        .package(path: ".."),
    ],
    targets: [
        .executableTarget(
            name: "TrafficNetworkExample",
            dependencies: [.product(name: "TrafficNetwork", package: "swift")],
            path: "Sources/TrafficNetworkExample"
        ),
    ]
)
