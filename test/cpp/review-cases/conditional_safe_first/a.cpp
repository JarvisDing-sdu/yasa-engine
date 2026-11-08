extern "C" char *getenv(const char*);
extern "C" int system(const char*);
namespace N {

#ifdef FEATURE
void route(char*){

}

#else
void route(char*p){
system(p);
}

#endif

}

void bad(){
N::route(getenv("X"));
}

