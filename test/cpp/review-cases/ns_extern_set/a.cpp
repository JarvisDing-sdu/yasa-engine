extern "C" char *getenv(const char*);
extern "C" int system(const char*);
namespace N {
extern char*p; void seed(); void bad(){
seed();system(p);
}
 
}

