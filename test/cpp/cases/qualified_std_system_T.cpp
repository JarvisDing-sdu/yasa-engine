#include <cstdlib>
void bad() {
    std::system(std::getenv("X"));
}
