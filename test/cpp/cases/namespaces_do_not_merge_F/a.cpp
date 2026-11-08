#include <stdlib.h>
namespace SeparatedSafeA {
void sink(char *s) { system(s); }
void bad() { sink((char *)"ls"); }
}
