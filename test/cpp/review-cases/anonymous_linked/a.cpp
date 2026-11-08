extern "C" char *getenv(const char*);
extern "C" int system(const char*);
namespace {
void hidden(char*p){
system(p);
}

}
 void good_a(){
hidden((char*)"safe");
}
