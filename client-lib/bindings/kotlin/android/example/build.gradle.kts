// The smallest app that uses the library: one Activity that connects, syncs
// and shows what is around. Not meant to be shipped — it is the code
// docs/integration-android.md walks through, compiled on every change.
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "info.trafficnetwork.example"
    compileSdk = 34

    defaultConfig {
        applicationId = "info.trafficnetwork.example"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation(project(":"))
}
