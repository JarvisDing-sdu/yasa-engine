#include <stdlib.h>
namespace B {
void sink(char *s) { (void)s; }
void bad() { sink(getenv("X")); }
}
