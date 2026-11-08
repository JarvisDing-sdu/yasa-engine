extern "C" char *getenv(const char*);
extern "C" int system(const char*);
char *cur=(char*)"safe";
char *next(){
return cur;
}

void bad(){
while(char*p=next()){
system(p);cur=getenv("X");
}

}
