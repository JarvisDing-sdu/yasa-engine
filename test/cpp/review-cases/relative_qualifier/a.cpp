extern "C" char *getenv(const char*);
extern "C" int system(const char*);
namespace X {
 namespace B {
void route(char *p){
system(p);
}

}
 void bad(){
B::route(getenv("X"));
}
 
}

