#include <stdlib.h>
void bad() {
    if (char *d = getenv("X"); d) system(d);
}
