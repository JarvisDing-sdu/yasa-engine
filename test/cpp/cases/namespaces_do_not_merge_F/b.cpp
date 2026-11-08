#include <stdlib.h>
namespace SeparatedSafeB {
void sink(char *s) { (void)s; }
void bad() { sink(getenv("X")); }
}
