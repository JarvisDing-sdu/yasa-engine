extern "C" char *getenv(const char*);
extern "C" int system(const char*);
void route(char *p){
system(p);
}
 namespace Missing{
void route(char*);
}
 void good(){
Missing::route(getenv("X"));
}
