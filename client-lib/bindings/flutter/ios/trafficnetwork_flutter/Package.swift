// swift-tools-version: 5.9
//
// The Swift Package half of the plugin (Flutter's SwiftPM plugin layout: ios/<plugin>/Package.swift, the library product named
// like the plugin with hyphens). The podspec next to this folder does the same job for CocoaPods; both ship the same XCFramework.
//
// The library is a DYNAMIC framework (built by ../../build-native.sh ios): Dart looks its functions up by name at run time, so
// nothing in the app refers to them, and a static library linked into the app would be left to the linker's dead-code stripping and
// to `strip` - which drop it. A dynamic framework is embedded and signed by Xcode like any other, and keeps its exported
// functions whatever the app's build settings say. Nothing to keep alive, no linker flags (docs/integration-flutter.md,
// "Why a dynamic framework").
import PackageDescription

let package = Package(
    name: "trafficnetwork_flutter",
    platforms: [
        .iOS("13.0"),
    ],
    products: [
        .library(name: "trafficnetwork-flutter", targets: ["trafficnetwork_flutter"]),
    ],
    targets: [
        // An empty target: a library product needs one, and it is what links the framework into the app.
        .target(
            name: "trafficnetwork_flutter",
            dependencies: ["TrafficNetworkDart"]
        ),
        // Not checked in: `bindings/flutter/build-native.sh ios` builds it from the Rust code.
        .binaryTarget(
            name: "TrafficNetworkDart",
            path: "Frameworks/TrafficNetworkDart.xcframework"
        ),
    ]
)
