extern "C" char *getenv(const char*);
extern "C" int system(const char*);
void route(char*); void bad(){
::route(getenv("X"));
}

