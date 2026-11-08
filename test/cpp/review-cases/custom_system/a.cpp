extern "C" char *getenv(const char*);
extern "C" int system(const char*);
namespace A {
void system(const char*){

}
 void good(){
system(getenv("X"));
}

}

