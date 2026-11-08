extern "C" char *getenv(const char*);
extern "C" int system(const char*);
namespace A {
 void route(char*p){
system(p);
}
 
}

void route(char*){

}

void bad(){
using A::route;route(getenv("X"));
}

