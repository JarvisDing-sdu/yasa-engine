extern "C" char *getenv(const char*);
extern "C" int system(const char*);
namespace N {
 void route(char *p){
system(p);
}
 
}

