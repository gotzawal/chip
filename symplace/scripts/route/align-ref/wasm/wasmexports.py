import sys
f=open(sys.argv[1],'rb').read()
p=8
def leb(p):
    r=0;s=0
    while True:
        b=f[p];p+=1
        r|=(b&0x7f)<<s;s+=7
        if b<0x80: return r,p
nimp_func=0
exports=[]
while p<len(f):
    sid=f[p];p+=1
    sz,p=leb(p)
    end=p+sz
    if sid==2:
        n,q=leb(p)
        for i in range(n):
            ml,q=leb(q); q+=ml
            fl,q=leb(q); q+=fl
            kind=f[q]; q+=1
            if kind==0: _,q=leb(q); nimp_func+=1
            elif kind==1:
                q+=1; fl2=f[q]; q+=1; _,q=leb(q)
                if fl2&1: _,q=leb(q)
            elif kind==2:
                fl2=f[q]; q+=1; _,q=leb(q)
                if fl2&1: _,q=leb(q)
            elif kind==3: q+=2
            elif kind==4: q+=1; _,q=leb(q)
    if sid==7:
        n,q=leb(p)
        for i in range(n):
            nl,q=leb(q); nm=f[q:q+nl].decode(); q+=nl
            kind=f[q]; q+=1
            idx,q=leb(q)
            exports.append((nm,kind,idx))
    p=end
print('imported funcs',nimp_func, 'exports', len(exports))
for nm,k,i in exports:
    if any(s in nm for s in sys.argv[2:]): print(k,i,nm)
