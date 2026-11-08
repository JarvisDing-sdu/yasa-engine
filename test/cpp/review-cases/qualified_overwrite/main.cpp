extern "C" char *getenv(const char*);
extern "C" int system(const char*);
namespace N {
 char *p; void good(){
p=getenv("X");N::p=(char*)"safe";system(p);
}
 
}
