// The Android library (AAR): the Kotlin that UniFFI generates (`generated/`,
// filled by ../generate.sh) and the native library for each Android ABI
// (`src/main/jniLibs/`, filled by cargo-ndk). Neither is checked in — both
// come from the Rust code, so they can never be out of step with it.
// docs/integration-android.md has the commands, in order.
plugins {
    id("com.android.library") version "8.7.3"
    id("org.jetbrains.kotlin.android") version "2.0.21"
}

android {
    namespace = "info.trafficnetwork.client"
    compileSdk = 34

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    sourceSets {
        getByName("main") {
            java.srcDir("generated")
        }
    }

    // A library has nothing to be linted into shape that the consuming app's
    // own lint will not look at again.
    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }
}

dependencies {
    // UniFFI's generated code reaches the native library through JNA; the AAR
    // flavour carries JNA's own native part for Android.
    api("net.java.dev.jna:jna:5.14.0@aar")
    // `suspend` calls (`callAsync`) need the coroutines library.
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
}
