extern "C" char *getenv(const char *);
extern "C" int system(const char *);
namespace A { char *p; }
void bad() { A::p = getenv("X"); using A::p; { const char *p = "safe"; system(p); } }
