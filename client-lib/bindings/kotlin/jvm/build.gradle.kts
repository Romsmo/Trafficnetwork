// The generated Kotlin bindings on a plain JVM — what the conformance run
// drives (conformance/run_bridge.mjs through src/main/kotlin/.../Bridge.kt)
// and the quickest way to try the binding without an Android toolchain. The
// generated sources are not checked in: `generated/` is filled by
// ../generate.sh from the compiled library.
plugins {
    kotlin("jvm") version "2.0.21"
    application
}

repositories {
    mavenCentral()
}

dependencies {
    // UniFFI's generated code calls the native library through JNA, and
    // `suspend` calls need the coroutines library.
    implementation("net.java.dev.jna:jna:5.14.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.8.1")
    // Only the conformance bridge parses JSON.
    implementation("org.json:json:20240303")
}

kotlin {
    jvmToolchain(17)
}

sourceSets {
    main {
        kotlin.srcDir("generated")
    }
}

application {
    mainClass.set("info.trafficnetwork.conformance.BridgeKt")
}
