extern "C" char *getenv(const char*);
extern "C" int system(const char*);
namespace A {
 void route(char *p){
system(p);
}
 
}

namespace B {
 void route(char*){

}
 
}

void bad(){
using namespace A; route(getenv("X"));
}

void good(){
using namespace B; route(getenv("X"));
}

