#pragma once
#include <memory>
#include <string>
namespace spdlog {
namespace level {
enum level_enum { trace, debug, info, warn, err, critical, off };
}
class logger {
 public:
  std::shared_ptr<logger> clone(const std::string&) { return std::make_shared<logger>(); }
  template <typename... A> void trace(A&&...) {}
  template <typename... A> void debug(A&&...) {}
  template <typename... A> void info(A&&...) {}
  template <typename... A> void warn(A&&...) {}
  template <typename... A> void error(A&&...) {}
  template <typename... A> void critical(A&&...) {}
  bool should_log(level::level_enum) { return false; }
};
inline std::shared_ptr<logger> default_logger() {
  static auto l = std::make_shared<logger>();
  return l;
}
}  // namespace spdlog
