extern "C" char *getenv(const char*);
extern "C" int system(const char*);
namespace N {
void route(char*); void bad();
}

void N::bad(){
route(getenv("X"));
}

