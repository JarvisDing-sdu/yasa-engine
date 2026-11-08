#include <stdlib.h>
namespace Hidden {
void run(char *s) { system(s); }
}
// no `using namespace Hidden;`: `run` here does not name Hidden::run
void bad() { run(getenv("X")); }
