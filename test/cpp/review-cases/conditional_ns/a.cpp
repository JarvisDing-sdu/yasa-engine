extern "C" char *getenv(const char*);
extern "C" int system(const char*);
namespace N {

#ifdef FEATURE
void route(char*p){
system(p);
}

#else
void route(char*){

}

#endif

}

void bad(){
N::route(getenv("X"));
}

