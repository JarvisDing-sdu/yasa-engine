extern "C" char *getenv(const char*);
extern "C" int system(const char*);
namespace A {
 char *p; void bad(){
char *p=getenv("X");system(p);
}
 
}
