extern "C" char *getenv(const char*);
extern "C" int system(const char*);
namespace N {
char *p; void bad(){
p=getenv("X");system(p);
}
 
}

