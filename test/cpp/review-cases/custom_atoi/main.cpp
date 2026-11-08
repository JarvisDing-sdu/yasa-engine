extern "C" char *getenv(const char *);
extern "C" int system(const char *);
namespace Custom { char *atoi(const char *unused) { return getenv("X"); } }
void bad() { system(Custom::atoi("ignored")); }
