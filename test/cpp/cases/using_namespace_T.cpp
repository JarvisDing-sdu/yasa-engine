#include <stdlib.h>
namespace A {
void run(char *s) { system(s); }
}
using namespace A;
void bad() { run(getenv("X")); }
