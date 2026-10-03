# Applied to every app that uses this library with code shrinking on: JNA finds
# its native callbacks and structures by reflection, and so does the generated
# binding. Without these an optimized release build fails at the first call.
-keep class com.sun.jna.** { *; }
-keepclassmembers class * extends com.sun.jna.* { public *; }
-keep class info.trafficnetwork.client.** { *; }
