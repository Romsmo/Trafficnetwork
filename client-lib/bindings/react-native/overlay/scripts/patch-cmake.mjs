// uniffi-bindgen-react-native writes android/CMakeLists.txt as if it were the
// top-level CMake project and finds the Rust static library through
// ${CMAKE_SOURCE_DIR}. React Native's autolinking of a C++ turbo module (what
// create-react-native-library's template sets up) instead adds that file to the
// *app's* CMake project as a subdirectory, where ${CMAKE_SOURCE_DIR} is the
// app's directory and the library is not found. ${CMAKE_CURRENT_SOURCE_DIR} is
// the library's android/ directory in both cases. Run after `ubrn build android`;
// fails if the generated file no longer has the line to fix, so a change in the
// generator is noticed rather than silently shipped.
import fs from "node:fs";

const file = "android/CMakeLists.txt";
const text = fs.readFileSync(file, "utf8");
const needle = "${CMAKE_SOURCE_DIR}/";
if (!text.includes(needle)) {
  throw new Error(`${file}: expected to find ${needle} (did uniffi-bindgen-react-native change its template?)`);
}
fs.writeFileSync(file, text.split(needle).join("${CMAKE_CURRENT_SOURCE_DIR}/"));
console.log(`${file}: the Rust library is now found relative to the library, not the app`);
