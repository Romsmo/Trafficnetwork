#
# The iOS half of the plugin is nothing but the native library: a dynamic
# framework in an XCFramework (built by ../build-native.sh, not checked in), which
# CocoaPods links and embeds into the app. Dart finds the library's functions by
# name at run time (dlsym); a dynamic framework keeps its exported functions
# whatever the app's strip and dead-code settings are - no -force_load, no
# STRIP_STYLE. The Swift Package (trafficnetwork_flutter/Package.swift) ships the
# same XCFramework for apps that build with Swift Package Manager.
#
Pod::Spec.new do |s|
  s.name             = 'trafficnetwork_flutter'
  s.version          = '1.2.0'
  s.summary          = 'The Trafficnetwork client for Flutter apps.'
  s.description      = 'The native library behind the trafficnetwork Dart package, bundled for iOS.'
  s.homepage         = 'https://github.com/Romsmo/Trafficnetwork'
  s.license          = { :type => 'Apache-2.0', :file => '../LICENSE' }
  s.author           = { 'Trafficnetwork' => 'https://github.com/Romsmo/Trafficnetwork' }
  s.source           = { :path => '.' }
  s.dependency 'Flutter'
  s.platform         = :ios, '13.0'

  s.vendored_frameworks = 'trafficnetwork_flutter/Frameworks/TrafficNetworkDart.xcframework'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'i386' }
end
