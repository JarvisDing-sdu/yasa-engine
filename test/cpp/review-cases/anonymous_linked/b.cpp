extern "C" char *getenv(const char*);
extern "C" int system(const char*);
void hidden(char*); void bad(){
hidden(getenv("X"));
}
