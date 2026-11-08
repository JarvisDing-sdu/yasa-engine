#include <stdlib.h>
namespace A {
void sink(char *s) { system(s); }
void bad() { sink(getenv("X")); }
}
