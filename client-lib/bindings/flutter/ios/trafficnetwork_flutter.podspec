#
# The iOS half of the plugin is nothing but the native library: a static
# XCFramework in Frameworks/ (built by ../build-native.sh, not checked in).
# Dart looks its functions up by name at run time, so nothing in the app
# refers to them and the linker would drop the whole library — hence the
# -force_load, and symbols that must not be stripped from the app.
#
Pod::Spec.new do |s|
  s.name             = 'trafficnetwork_flutter'
  s.version          = '1.1.0'
  s.summary          = 'The Trafficnetwork client for Flutter apps.'
  s.description      = 'The native library behind the trafficnetwork Dart package, bundled for iOS.'
  s.homepage         = 'https://github.com/Romsmo/Trafficnetwork'
  s.license          = { :type => 'Apache-2.0', :file => '../LICENSE' }
  s.author           = { 'Trafficnetwork' => 'https://github.com/Romsmo/Trafficnetwork' }
  s.source           = { :path => '.' }
  s.dependency 'Flutter'
  s.platform         = :ios, '13.0'

  s.vendored_frameworks = 'Frameworks/TrafficNetworkDart.xcframework'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'i386' }
  s.user_target_xcconfig = {
    'OTHER_LDFLAGS[sdk=iphoneos*]' => '$(inherited) -force_load "${PODS_ROOT}/../.symlinks/plugins/trafficnetwork_flutter/ios/Frameworks/TrafficNetworkDart.xcframework/ios-arm64/libtrafficnetwork_dart.a"',
    'OTHER_LDFLAGS[sdk=iphonesimulator*]' => '$(inherited) -force_load "${PODS_ROOT}/../.symlinks/plugins/trafficnetwork_flutter/ios/Frameworks/TrafficNetworkDart.xcframework/ios-arm64_x86_64-simulator/libtrafficnetwork_dart.a"',
    'STRIP_STYLE' => 'non-global',
  }
end
