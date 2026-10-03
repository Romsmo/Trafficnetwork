#!/usr/bin/env node
// Creates the React Native library (a turbo module) around the UniFFI crate:
//
//     node bindings/react-native/scaffold.mjs [directory]     (default: bindings/react-native/library)
//
// A React Native library is a lot of boilerplate (an example app with Android
// and iOS projects, a podspec, codegen configuration) that
// `create-react-native-library` writes better than we could keep up to date,
// so it is generated rather than checked in; this script then adds what is
// ours: the uniffi-bindgen-react-native dependency and scripts, its
// configuration, and the example app's screen. After it, in the directory:
//
//     yarn install
//     yarn ubrn:android      # Rust for Android + the TypeScript/C++ bindings
//     yarn ubrn:ios          # Rust for iOS (on a Mac) + the same, as an XCFramework
//
// The tool versions are pinned: both are young and move fast.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(process.argv[2] ?? path.join(here, "library"));

const CREATE_RN_LIBRARY = "create-react-native-library@0.63.1";
const UBRN = "0.31.0-6";

if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
  console.error(`${target} is not empty — remove it first`);
  process.exit(1);
}

execFileSync(
  "npx",
  [
    "--yes",
    CREATE_RN_LIBRARY,
    "--no-interactive",
    "--directory", target,
    "--slug", "@trafficnetwork/react-native",
    "--description", "The Trafficnetwork client for React Native",
    "--author-name", "Trafficnetwork",
    "--author-email", "noreply@trafficnetwork.info",
    "--author-url", "https://trafficnetwork.info",
    "--repo-url", "https://github.com/Romsmo/Trafficnetwork",
    "--type", "turbo-module",
    "--languages", "cpp",
    "--example", "vanilla",
  ],
  { stdio: "inherit", shell: process.platform === "win32" },
);

// It initializes a git repository of its own; ours is the one that counts.
fs.rmSync(path.join(target, ".git"), { recursive: true, force: true });

const manifestPath = path.join(target, "package.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.dependencies = {
  ...manifest.dependencies,
  "uniffi-bindgen-react-native": UBRN,
  "@ubjs/core": UBRN,
};
manifest.scripts = {
  ...manifest.scripts,
  "ubrn:android": "ubrn build android --and-generate",
  "ubrn:ios": "ubrn build ios --and-generate && (cd example/ios && pod install)",
  "ubrn:clean":
    "rm -rf cpp/ android/CMakeLists.txt android/src/main/java android/*.cpp ios/ src/Native* src/index.*ts* src/generated/",
};
manifest.license = "Apache-2.0";
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

fs.copyFileSync(path.join(here, "ubrn.config.yaml"), path.join(target, "ubrn.config.yaml"));

// Our screens over the template's.
const overlay = path.join(here, "overlay");
(function copy(from, to) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const destination = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destination, { recursive: true });
      copy(source, destination);
    } else {
      fs.copyFileSync(source, destination);
    }
  }
})(overlay, target);

console.log(`\nReact Native library scaffolded in ${target}`);
