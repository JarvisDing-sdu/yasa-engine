#include <stdlib.h>
#include "api.h"
namespace api {
void exec(char *s) { system(s); }
}
void bad() { api::exec(getenv("X")); }
