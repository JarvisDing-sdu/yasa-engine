extern "C" char *getenv(const char*);
extern "C" int system(const char*);
namespace A {
 void route(char*p){
system(p);
}
 
}

namespace B {
 void route(char*){

}
 
}

void good(){
 {
 using namespace A; route((char*)"safe"); 
}
 {
 using namespace B; route(getenv("X")); 
}
 
}

