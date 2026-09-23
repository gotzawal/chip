#pragma once
#include <ostream>
#include <string>
namespace nlohmann {
struct json {
  json() {}
  json(const json&) = default;
  json& operator=(const json&) = default;
  template <typename T> json(const T&) {}
  template <typename T> json& operator=(const T&) { return *this; }
  json& operator[](const char*) { return *this; }
  json& operator[](const std::string&) { return *this; }
  template <typename T> void push_back(const T&) {}
  static json array() { return json(); }
};
inline std::ostream& operator<<(std::ostream& o, const json&) { return o; }
}  // namespace nlohmann
