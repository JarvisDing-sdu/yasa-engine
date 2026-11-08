extern "C" char *getenv(const char*);
extern "C" int system(const char*);
char *cur=(char*)"safe";
char *next(){
return cur;
}

void bad(){
char*p;while((p=next())){
system(p);cur=getenv("X");
}

}
