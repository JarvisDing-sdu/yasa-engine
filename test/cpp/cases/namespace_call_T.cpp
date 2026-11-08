#include <stdlib.h>
namespace A {
void bad() {
    char *d = getenv("X");
    system(d);
}
}
