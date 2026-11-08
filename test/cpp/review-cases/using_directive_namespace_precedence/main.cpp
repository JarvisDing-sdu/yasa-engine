extern "C" char *getenv(const char *);
extern "C" int system(const char *);
namespace A { char *route() { return getenv("X"); } }
namespace B {
const char *route() { return "safe"; }
void bad() { using namespace A; system(route()); }
}
