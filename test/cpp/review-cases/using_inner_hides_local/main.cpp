extern "C" char *getenv(const char *);
extern "C" int system(const char *);
namespace A { char *p; }
void bad() { A::p = getenv("X"); const char *p = "safe"; { using A::p; system(p); } }
