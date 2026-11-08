#include <stdlib.h>
namespace SeparatedTaintedA {
void sink(char *s) { system(s); }
void bad() { sink(getenv("X")); }
}
