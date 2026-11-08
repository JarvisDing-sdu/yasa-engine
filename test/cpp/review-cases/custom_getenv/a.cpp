extern "C" char *getenv(const char*);
extern "C" int system(const char*);
namespace A {
char* getenv(const char*){
return (char*)"safe";
}
 void good(){
::system(getenv("X"));
}

}

