// swift-tools-version:5.9
//
// The Swift package: the Swift that UniFFI generates (`Sources/TrafficNetwork/`)
// on top of the native library packaged as an XCFramework
// (`TrafficNetworkFFI.xcframework`). Neither is checked in - both come out of
// the Rust code, so they cannot be out of step with it. `build-xcframework.sh`
// makes both; docs/integration-ios.md has the steps and how to add the result
// to an app.
import PackageDescription

let package = Package(
    name: "TrafficNetwork",
    platforms: [.iOS(.v13), .macOS(.v11)],
    products: [
        .library(name: "TrafficNetwork", targets: ["TrafficNetwork"]),
    ],
    targets: [
        .binaryTarget(
            name: "TrafficNetworkFFI",
            path: "TrafficNetworkFFI.xcframework"
        ),
        .target(
            name: "TrafficNetwork",
            dependencies: ["TrafficNetworkFFI"],
            path: "Sources/TrafficNetwork"
        ),
    ]
)
